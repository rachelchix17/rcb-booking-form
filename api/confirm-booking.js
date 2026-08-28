// POST /api/confirm-booking
// Records a secured booking:
//   1) Verifies the saved card with Stripe (the card is ALWAYS captured, for both the
//      "Credit Card" and "Cash" payment options - it holds the booking either way).
//   2) Moves the customer's row from the Accepted Quotes board to the BOOKED board in
//      monday.com (matched on Quote No), then sets Payment Option, CC Captured = Yes,
//      Booking Date and Status = Booked. Creates the row on Booked if it isn't found.
//   3) Posts a note on the item with a one-click link to the Stripe customer so Michael
//      can charge the saved card manually after the job.
//   4) If monday fails, forwards the booking to a fallback webhook (optional).
//
// Env vars used:
//   STRIPE_SECRET_KEY        (verify the SetupIntent)
//   MONDAY_API_TOKEN         (monday.com personal API token)
//   MONDAY_BOARD_ID          (Accepted Quotes - source, default below)
//   MONDAY_BOOKED_BOARD_ID   (Booked - destination, default below)
//   FALLBACK_WEBHOOK_URL     (optional - a Zapier/Make catch hook to email/log the lead)
//
// The admin@ email notification is sent by a separate Zapier + Outlook Zap that
// triggers off the Booked board (CC Captured = Yes), not from this function.

const Stripe = require('stripe');

// ---- Accepted Quotes board (source: where the accepted quote currently lives) -----
const ACCEPTED_BOARD_ID = '5026836555';
const ACCEPTED_QUOTE_COL = 'text_mky97d5j'; // Quote No (same id as on Booked)

// ---- Booked board (destination) ---------------------------------------------------
const BOOKED_BOARD_ID = '5026732973';
const BOOKED_GROUP_ID = 'topics'; // "Booked" group
const B = {
  quoteNo:      'text_mky97d5j',    // Quote No (match key)
  firstName:    'text_mky2rjx',     // First Name
  lastName:     'text_mky2hsbn',    // Last Name
  email:        'email_mktsw3sy',   // Email
  phone:        'text_mktsahr0',    // Contact Number
  address:      'long_text_mkq6pxf0', // Address
  bookingDate:  'date_mm2n6ng7',    // Booking Date
  paymentOpt:   'dropdown_mm2navps', // Payment Option: Credit Card=1, Cash=2
  ccCaptured:   'dropdown_mm2n6aqw', // CC Captured: Yes=1, No=2
  status:       'status',           // Status: Booked=0
  submittedFrom:'text_mm4w9mca',    // Submitted From (Page)
  cardOnFile:   'text_mm6mqcz',     // Card on File (brand + last 4, no full number)
  chargeLink:   'link_mm6ndvx6',    // Charge in Stripe (clickable link to the Stripe customer)
  source:       'color_mkq6jxk3',   // Source (status) - tag booking as Roof Cleaners Brisbane
};
// This project is the Roof Cleaners Brisbane booking page. It shares the same
// Monday boards and Stripe as House Washing Experts, so every booking is tagged
// Source = "Roof Cleaners Brisbane" to keep the two brands separable.
const SOURCE_RCB_LABEL = 'Roof Cleaners Brisbane';
const PAYMENT_OPTION = { card: 1, cash: 2 };
const CC_CAPTURED_YES = 1;
const STATUS_BOOKED_LABEL = 'Booked';
// -----------------------------------------------------------------------------------

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

async function mondayGraphQL(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('MONDAY_API_TOKEN not configured');
  const resp = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) throw new Error('monday API error: ' + JSON.stringify(json.errors));
  return json.data;
}

async function findItemByQuoteNo(boardId, quoteNo) {
  const query = `
    query ($boardId: ID!, $columnId: String!, $value: String!) {
      items_page_by_column_values(
        board_id: $boardId,
        limit: 1,
        columns: [{ column_id: $columnId, column_values: [$value] }]
      ) { items { id name } }
    }`;
  const data = await mondayGraphQL(query, { boardId, columnId: ACCEPTED_QUOTE_COL, value: quoteNo });
  const items = data?.items_page_by_column_values?.items || [];
  return items.length ? items[0] : null;
}

async function moveItemToBoard(itemId, boardId, groupId) {
  const query = `
    mutation ($itemId: ID!, $boardId: ID!, $groupId: ID!) {
      move_item_to_board(item_id: $itemId, board_id: $boardId, group_id: $groupId) { id }
    }`;
  return mondayGraphQL(query, { itemId, boardId, groupId });
}

async function updateItem(boardId, itemId, columnValues) {
  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $vals: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) { id }
    }`;
  return mondayGraphQL(query, { boardId, itemId, vals: JSON.stringify(columnValues) });
}

async function createItem(boardId, name, columnValues) {
  const query = `
    mutation ($boardId: ID!, $group: String!, $name: String!, $vals: JSON!) {
      create_item(board_id: $boardId, group_id: $group, item_name: $name, column_values: $vals, create_labels_if_missing: false) { id }
    }`;
  const data = await mondayGraphQL(query, {
    boardId, group: BOOKED_GROUP_ID, name, vals: JSON.stringify(columnValues),
  });
  return data?.create_item?.id;
}

async function postUpdate(itemId, body) {
  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`;
  return mondayGraphQL(query, { itemId, body });
}

// Sends a monday notification (bell + email, per the recipient's settings) to a
// user, linked to the booking item. Used to alert admin@ / May on each booking.
async function createNotification(userId, itemId, text) {
  const query = `
    mutation ($userId: ID!, $targetId: ID!, $text: String!) {
      create_notification(user_id: $userId, target_id: $targetId, target_type: Project, text: $text) { id }
    }`;
  return mondayGraphQL(query, { userId, targetId: itemId, text });
}

function splitName(fullName, first, last) {
  if (first || last) return { first: first || '', last: last || '' };
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readBody(req);
    const paymentType = body.payment_type === 'cash' ? 'cash' : 'card'; // Payment Option only
    const quoteNo = (body.quote_no || '').trim();
    const fullName = (body.full_name || '').trim();
    const email = (body.email || '').trim();
    const phone = (body.phone || '').trim();
    const address = (body.address || '').trim();
    const bookingDate = (body.booking_date || '').trim();
    const submittedFrom = (body.submitted_from || 'RCB Secure My Booking page').trim();

    // ---- The card is ALWAYS captured (both options). Verify with Stripe. ----
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured.' });
    const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });

    const setupIntentId = (body.setupIntentId || '').trim();
    if (!setupIntentId) return res.status(400).json({ error: 'Missing setupIntentId (card not captured).' });

    const si = await stripe.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
    if (si.status !== 'succeeded') {
      return res.status(400).json({ error: `Card not saved (status: ${si.status}).` });
    }
    const customerId = typeof si.customer === 'string' ? si.customer : (si.customer && si.customer.id);
    const pm = si.payment_method;
    const paymentMethodId = typeof pm === 'string' ? pm : (pm && pm.id);
    let cardBrand = '', cardLast4 = '';
    if (pm && pm.card) { cardBrand = pm.card.brand; cardLast4 = pm.card.last4; }

    // ---- Build the Booked-board column values ----
    const acceptedBoardId = process.env.MONDAY_BOARD_ID || ACCEPTED_BOARD_ID;
    const bookedBoardId = process.env.MONDAY_BOOKED_BOARD_ID || BOOKED_BOARD_ID;
    const { first, last } = splitName(fullName, body.first_name, body.last_name);

    const bookedValues = {
      [B.quoteNo]: quoteNo,
      [B.firstName]: first,
      [B.lastName]: last,
      [B.phone]: phone,
      [B.address]: address,
      [B.submittedFrom]: submittedFrom,
      [B.source]: { label: SOURCE_RCB_LABEL }, // tag brand = Roof Cleaners Brisbane
      [B.paymentOpt]: { ids: [ PAYMENT_OPTION[paymentType] ] },
      [B.ccCaptured]: { ids: [ CC_CAPTURED_YES ] }, // always Yes
      [B.status]: { label: STATUS_BOOKED_LABEL },
    };
    if (email) bookedValues[B.email] = { email, text: email };
    if (bookingDate) bookedValues[B.bookingDate] = { date: bookingDate };
    // Card brand + last 4 (no full number) into the "Card on File" column, so the
    // Zapier/Outlook notification can pull it straight from a column.
    if (cardLast4) bookedValues[B.cardOnFile] = `${cardBrand ? cardBrand + ' ' : ''}ending ${cardLast4}`;

    // Stripe dashboard deep-link (test vs live) for the note Michael reads.
    const isLive = secretKey.startsWith('sk_live_');
    const custLink = customerId
      ? `https://dashboard.stripe.com/${isLive ? '' : 'test/'}customers/${customerId}`
      : '';
    // Put the Stripe link straight on the lead (clickable) so the saved card can be
    // charged from monday. This replaces the old item-update note (which double-emailed
    // the lead owner). The note is gone; this column keeps the charge link on the lead.
    if (custLink) bookedValues[B.chargeLink] = { url: custLink, text: 'Charge saved card' };

    let recorded = false;
    let mondayError = null;
    try {
      // 1) Find the accepted-quote row and MOVE it to the Booked board.
      let itemId = null;
      const acceptedItem = await findItemByQuoteNo(acceptedBoardId, quoteNo);
      if (acceptedItem) {
        await moveItemToBoard(acceptedItem.id, bookedBoardId, BOOKED_GROUP_ID);
        itemId = acceptedItem.id; // id is unchanged after the move
      } else {
        // Maybe it's already on the Booked board; otherwise create it there.
        const bookedItem = await findItemByQuoteNo(bookedBoardId, quoteNo);
        if (bookedItem) itemId = bookedItem.id;
      }

      // 2) Set the Booked-board fields (payment option, CC captured, date, status).
      if (itemId) {
        await updateItem(bookedBoardId, itemId, bookedValues);
      } else {
        const name = fullName || email || quoteNo || 'Website Booking';
        itemId = await createItem(bookedBoardId, name, bookedValues);
      }

      // 3) (Removed) We used to post an item update note here, but monday
      // emails the lead owner about every update, which meant the owner got
      // TWO emails per booking. The createNotification below already carries
      // the full booking details (with an Open Lead button), so we keep only
      // that one. The saved-card details still live on the board columns
      // (Card on File, Stripe Charge ID) for charging later.

      // Notify admin (and anyone else configured) with the full booking details.
      // NOTIFY_MONDAY_USER_IDS = comma-separated monday user ids. Default = Michael (admin@).
      const notifyIds = (process.env.NOTIFY_MONDAY_USER_IDS || '74526990')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (itemId && notifyIds.length) {
        const notifText = [
          `New booking secured - ${quoteNo}`,
          fullName ? `Customer: ${fullName}` : '',
          bookingDate ? `Booking date: ${bookingDate}` : '',
          `Payment option: ${paymentType === 'cash' ? 'Cash' : 'Credit Card'} | CC captured: Yes`,
          phone ? `Phone: ${phone}` : '',
          email ? `Email: ${email}` : '',
          address ? `Address: ${address}` : '',
          cardBrand ? `Card: ${cardBrand} ending ${cardLast4}` : '',
          custLink ? `Charge in Stripe: ${custLink}` : '',
        ].filter(Boolean).join('\n');
        for (const uid of notifyIds) {
          try { await createNotification(uid, itemId, notifText); }
          catch (e) { console.error('monday notify failed for', uid, e.message); }
        }
      }

      recorded = true;
    } catch (e) {
      mondayError = e.message;
      console.error('monday save failed:', e);
      const webhook = process.env.FALLBACK_WEBHOOK_URL;
      if (webhook) {
        try {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'RCB booking page (monday fallback)',
              quote_no: quoteNo, full_name: fullName, email, phone, address,
              booking_date: bookingDate, payment_option: paymentType, cc_captured: 'Yes',
              stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId,
              stripe_customer_link: custLink, monday_error: mondayError,
            }),
          });
          recorded = true;
        } catch (fe) {
          console.error('fallback webhook failed:', fe);
        }
      }
    }

    // The card is already saved in Stripe, so the booking is secure regardless of CRM.
    return res.status(200).json({
      success: true,
      recorded,
      stripe_customer_id: customerId || null,
      warning: mondayError && !recorded ? 'Card saved in Stripe but CRM record failed - check server logs and fallback webhook.' : undefined,
    });
  } catch (err) {
    console.error('confirm-booking error:', err);
    return res.status(500).json({ error: err.message || 'Failed to confirm booking.' });
  }
};

// POST /api/confirm-booking-nocard
// Records a NO-CARD booking for Roof Cleaners Brisbane (customer confirmed without
// sharing card details). This endpoint NEVER touches Stripe. It only writes to
// monday.com and notifies the team:
//   1) Moves the customer's row from the Accepted Quotes board to the BOOKED board
//      (matched on Quote No), tags Source = Roof Cleaners Brisbane, sets Payment
//      Option (their stated preference), CC Captured = No, Booking Date, Status = Booked.
//      Creates the row on Booked if it isn't found.
//   2) Sends a monday notification (with an Open Lead link) to the configured users,
//      flagging that no card was captured and payment is arranged after the job.
//   3) If monday fails, forwards the booking to a fallback webhook (optional).
//
// Completely separate from confirm-booking.js (the card flow); shares no code, so the
// card-capture backend is never affected.
//
// Env vars used (same as confirm-booking.js, minus Stripe):
//   MONDAY_API_TOKEN, MONDAY_BOARD_ID (Accepted Quotes source),
//   MONDAY_BOOKED_BOARD_ID (Booked destination), FALLBACK_WEBHOOK_URL (optional),
//   NOTIFY_MONDAY_USER_IDS (comma-separated monday user ids; default = Michael)

// ---- Accepted Quotes board (source) ----
const ACCEPTED_BOARD_ID = '5026836555';
const ACCEPTED_QUOTE_COL = 'text_mky97d5j'; // Quote No

// ---- Booked board (destination) ----
const BOOKED_BOARD_ID = '5026732973';
const BOOKED_GROUP_ID = 'topics'; // "Booked" group
const B = {
  quoteNo:      'text_mky97d5j',
  firstName:    'text_mky2rjx',
  lastName:     'text_mky2hsbn',
  email:        'email_mktsw3sy',
  phone:        'text_mktsahr0',
  address:      'long_text_mkq6pxf0',
  bookingDate:  'date_mm2n6ng7',
  paymentOpt:   'dropdown_mm2navps', // Credit Card=1, Cash=2
  ccCaptured:   'dropdown_mm2n6aqw', // Yes=1, No=2
  status:       'status',
  submittedFrom:'text_mm4w9mca',
  source:       'color_mkq6jxk3',    // Source (status) - tag Roof Cleaners Brisbane
};
const SOURCE_RCB_LABEL = 'Roof Cleaners Brisbane';
const PAYMENT_OPTION = { card: 1, cash: 2 };
const CC_CAPTURED_NO = 2;
const STATUS_BOOKED_LABEL = 'Booked';

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

// Sends a monday notification (bell + email, per the recipient's settings) linked to
// the booking item.
async function createNotification(userId, itemId, text) {
  const query = `
    mutation ($userId: ID!, $targetId: ID!, $text: String!) {
      create_notification(user_id: $userId, target_id: $targetId, target_type: Project, text: $text) { id }
    }`;
  return mondayGraphQL(query, { userId, targetId: itemId, text });
}

// Returns the monday user id(s) assigned to the lead in the Agent (people) column,
// so we can notify the lead owner as well as the default admin.
async function getItemOwnerIds(itemId) {
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        column_values(ids: ["person"]) { value }
      }
    }`;
  try {
    const data = await mondayGraphQL(query, { itemId: [itemId] });
    const raw = data?.items?.[0]?.column_values?.[0]?.value;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => String(p.id));
  } catch (e) {
    console.error('owner lookup failed:', e.message);
    return [];
  }
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
    const paymentType = body.payment_type === 'cash' ? 'cash' : 'card'; // preference only
    const quoteNo = (body.quote_no || '').trim();
    const fullName = (body.full_name || '').trim();
    const email = (body.email || '').trim();
    const phone = (body.phone || '').trim();
    const address = (body.address || '').trim();
    const bookingDate = (body.booking_date || '').trim();
    const submittedFrom = (body.submitted_from || 'RCB no-card booking page').trim();

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
      [B.ccCaptured]: { ids: [ CC_CAPTURED_NO ] }, // always No on this endpoint
      [B.status]: { label: STATUS_BOOKED_LABEL },
    };
    if (email) bookedValues[B.email] = { email, text: email };
    if (bookingDate) bookedValues[B.bookingDate] = { date: bookingDate };

    let recorded = false;
    let mondayError = null;
    try {
      // 1) Find the accepted-quote row and MOVE it to the Booked board.
      let itemId = null;
      const acceptedItem = await findItemByQuoteNo(acceptedBoardId, quoteNo);
      if (acceptedItem) {
        await moveItemToBoard(acceptedItem.id, bookedBoardId, BOOKED_GROUP_ID);
        itemId = acceptedItem.id;
      } else {
        const bookedItem = await findItemByQuoteNo(bookedBoardId, quoteNo);
        if (bookedItem) itemId = bookedItem.id;
      }

      // 2) Set the Booked-board fields.
      if (itemId) {
        await updateItem(bookedBoardId, itemId, bookedValues);
      } else {
        const name = fullName || email || quoteNo || 'Website Booking';
        itemId = await createItem(bookedBoardId, name, bookedValues);
      }

      // 3) Notify the team with the full booking details (no card / no Stripe link).
      //    Default admin(s) from NOTIFY_MONDAY_USER_IDS, PLUS the lead owner (Agent).
      const adminIds = (process.env.NOTIFY_MONDAY_USER_IDS || '74526990')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const ownerIds = itemId ? await getItemOwnerIds(itemId) : [];
      const notifyIds = [...new Set([...adminIds, ...ownerIds])];
      if (itemId && notifyIds.length) {
        const notifText = [
          `New no-card booking secured - ${quoteNo}`,
          fullName ? `Customer: ${fullName}` : '',
          bookingDate ? `Booking date: ${bookingDate}` : '',
          `Payment option: ${paymentType === 'cash' ? 'Cash' : 'Credit Card'} | CC captured: No`,
          phone ? `Phone: ${phone}` : '',
          email ? `Email: ${email}` : '',
          address ? `Address: ${address}` : '',
          'No card was captured. Please arrange payment directly once the job is completed.',
        ].filter(Boolean).join('\n');
        for (const uid of notifyIds) {
          try { await createNotification(uid, itemId, notifText); }
          catch (e) { console.error('monday notify failed for', uid, e.message); }
        }
      }

      recorded = true;
    } catch (e) {
      mondayError = e.message;
      console.error('monday save failed (no-card):', e);
      const webhook = process.env.FALLBACK_WEBHOOK_URL;
      if (webhook) {
        try {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'RCB no-card booking page (monday fallback)',
              quote_no: quoteNo, full_name: fullName, email, phone, address,
              booking_date: bookingDate, payment_option: paymentType, cc_captured: 'No',
              monday_error: mondayError,
            }),
          });
          recorded = true;
        } catch (fe) {
          console.error('fallback webhook failed:', fe);
        }
      }
    }

    return res.status(200).json({
      success: true,
      recorded,
      warning: mondayError && !recorded ? 'Booking not recorded in CRM - check server logs and fallback webhook.' : undefined,
    });
  } catch (err) {
    console.error('confirm-booking-nocard error:', err);
    return res.status(500).json({ error: err.message || 'Failed to confirm booking.' });
  }
};

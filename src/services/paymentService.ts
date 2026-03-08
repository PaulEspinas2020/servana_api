import dbQuery from "../db/dbQuery";

export const submitGcash = async (bookingId: number, reference_no: string, proof_url?: string) => {
  const r = await dbQuery.query(
    `
    UPDATE payments
    SET method='GCASH',
        reference_no=$2,
        proof_url=$3,
        status='PENDING'
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId, reference_no, proof_url || null]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");
  return r.rows[0];
};

export const approvePayment = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE payments
    SET status='PAID', paid_at=NOW()
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");
  return r.rows[0];
};

export const markCashPaid = async (bookingId: number) => {
  const r = await dbQuery.query(
    `
    UPDATE payments
    SET method='CASH', status='PAID', paid_at=NOW()
    WHERE booking_id=$1
    RETURNING *
    `,
    [bookingId]
  );
  if (!r.rowCount) throw new Error("Payment record not found.");
  return r.rows[0];
};

import { Prisma } from "@prisma/client";

// Admin queries alias the immutable payment order as p. Only confirmed money
// changes its operator-facing status; pending/unknown refunds do not.
const paid = Prisma.sql`COALESCE((SELECT amount FROM payment_transactions WHERE order_id=p.id),0)`;
const refunded = Prisma.sql`COALESCE((SELECT sum(amount) FROM refunds WHERE order_id=p.id AND state='succeeded'),0)`;
export const adminOrderState = Prisma.sql`CASE WHEN ${paid}>0 AND ${refunded}>0 THEN CASE WHEN ${refunded}>=${paid} THEN 'refunded' ELSE 'partially_refunded' END ELSE p.state END`;

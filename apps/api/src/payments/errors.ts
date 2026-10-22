import { ConflictException } from "@nestjs/common";
export class PaymentIdempotencyConflict extends ConflictException {}

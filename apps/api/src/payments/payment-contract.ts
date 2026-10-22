import { ApiProperty } from "@nestjs/swagger";
class PaymentProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    type: Object,
    description: "One subject; payment never grants subject consent",
  })
  subject!: object;
  @ApiProperty() bookTitle!: string;
  @ApiProperty({ type: Object }) recipient!: object;
  @ApiProperty({
    type: Object,
    description:
      "Frozen initial personal plan with source template and revision",
  })
  plan!: object;
  @ApiProperty({ type: Object, description: "Unique first-copy entitlement" })
  entitlement!: object;
  @ApiProperty({
    type: Object,
    description:
      "Independent frozen service clocks; unselected policy remains pending",
  })
  terms!: object;
}
export class PaymentOrderDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() outTradeNo!: string;
  @ApiProperty({ enum: [99900] }) amount!: number;
  @ApiProperty({ enum: ["CNY"] }) currency!: string;
  @ApiProperty({ enum: ["local-verification"] }) mode!: string;
  @ApiProperty({ enum: ["pending", "paid", "closed"] }) state!: string;
  @ApiProperty({ format: "uuid" }) packageVersionId!: string;
  @ApiProperty({ type: Object }) recipient!: object;
  @ApiProperty({ type: Object }) template!: object;
  @ApiProperty({ nullable: true, type: String }) subjectName!: string | null;
  @ApiProperty() bookTitle!: string;
  @ApiProperty({ type: PaymentProjectDto, nullable: true })
  project!: PaymentProjectDto | null;
}
class ResponseMeta {
  @ApiProperty() requestId!: string;
}
export class PaymentOrderResponseDto {
  @ApiProperty({ type: PaymentOrderDto }) data!: PaymentOrderDto;
  @ApiProperty({ type: ResponseMeta }) meta!: ResponseMeta;
}
class OrderCollection {
  @ApiProperty({ type: [PaymentOrderDto] }) orders!: PaymentOrderDto[];
}
export class PaymentOrdersResponseDto {
  @ApiProperty({ type: OrderCollection }) data!: OrderCollection;
  @ApiProperty({ type: ResponseMeta }) meta!: ResponseMeta;
}
class PreparedPaymentDto {
  @ApiProperty({ enum: ["local-verification"] }) mode!: string;
  @ApiProperty({ enum: ["prepared", "pending", "unknown", "paid", "closed"] })
  status!: string;
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      "RSA-signed mini-program contract, synthetic only; never pass to real wx.requestPayment",
  })
  parameters!: object | null;
}
export class PreparedPaymentResponseDto {
  @ApiProperty({ type: PreparedPaymentDto }) data!: PreparedPaymentDto;
  @ApiProperty({ type: ResponseMeta }) meta!: ResponseMeta;
}

import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  Header,
  Injectable,
  Inject,
  OnModuleDestroy,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiProperty,
  ApiHeader,
  ApiCookieAuth,
} from "@nestjs/swagger";
import {
  IsInt,
  Min,
  Max,
  IsString,
  MaxLength,
  Matches,
  IsUUID,
  IsIn,
  IsOptional,
  Equals,
} from "class-validator";
import { Prisma, FirstCopyOrder } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type {
  FirstCopyContext,
  FirstCopyAddress,
  FirstCopyBinding,
  FirstCopyBlocker,
  FirstCopyOrderView,
  FirstCopyApprovalView,
} from "@timenook/contracts";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import { API_CONFIG, ApiConfig } from "../config";
import { Participation } from "../identity/participation";
import { ProjectServiceTerms } from "../projects/service-terms";
import { publicTerms } from "../catalog/package-terms";
import { Books } from "./books";
import { idempotencyKey } from "../payments/orders";
import { AdminAccess } from "../admin/admin-access";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const json = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v));
const MAINLAND_MOBILE = /^1\d{10}$/;
type SalesSnapshot = {
  d01: {
    minPages: number;
    maxPages: number;
    widthMm: number;
    heightMm: number;
    bleedMm: number;
  };
  shippingRegionLabels: Record<string, string>;
  admission: {
    d05: {
      includedRegionCodes: string[];
      excludedRegionCodes: string[];
      shippingFeeIncluded: boolean;
    };
  };
};
type Actor = Parameters<Parameters<Participation["withPlanAccess"]>[3]>[1];

class FirstCopyAddressDto implements FirstCopyAddress {
  @ApiProperty() @IsInt() @Min(0) @Max(2147483646) expectedVersion!: number;
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  @Matches(/\S/)
  recipientName!: string;
  @ApiProperty() @IsString() @Matches(MAINLAND_MOBILE) phone!: string;
  @ApiProperty() @IsString() @MaxLength(40) regionCode!: string;
  @ApiProperty() @IsString() @MaxLength(300) @Matches(/\S/) detail!: string;
}
class SubmitFirstCopyDto implements FirstCopyBinding {
  @ApiProperty() @IsUUID() bookVersionId!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) snapshotHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) pdfHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) addressHash!: string;
}
class BookConfirmationDto {
  @ApiProperty({ enum: ["narrator", "initiator"] })
  @IsIn(["narrator", "initiator"])
  role!: "narrator" | "initiator";
  @ApiProperty() @IsUUID() bookVersionId!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) snapshotHash!: string;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) pdfHash!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  addressHash?: string;
  @ApiProperty() @Equals("synthetic-d08-v1") noticeVersion!: string;
  @ApiProperty() @Matches(/^synthetic:[^\r\n]{3,160}$/) evidenceRef!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  assistedSessionId?: string;
}
@Injectable()
export class FirstCopies implements OnModuleDestroy {
  private readonly terms: ProjectServiceTerms;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly participation: Participation,
    private readonly books: Books,
  ) {
    this.terms = new ProjectServiceTerms(config.databaseUrl);
  }
  private orderView(row: FirstCopyOrder): FirstCopyOrderView {
    return {
      id: row.id,
      state: row.state as FirstCopyOrderView["state"],
      bookVersionId: row.bookId,
      snapshotHash: row.snapshotHash,
      pdfHash: row.pdfHash,
      addressHash: row.addressHash,
      copies: 1,
      amountDueFen: 0,
    };
  }
  private async contextIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: Actor,
  ): Promise<FirstCopyContext> {
    const project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
      }),
      order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: project.orderId! },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId },
      }),
      context = await this.books.contextIn(
        tx,
        projectId,
        actor.accessExpiresAt,
      ),
      terms = await this.terms.read(projectId, undefined, tx),
      address = await tx.firstCopyAddress.findUnique({ where: { projectId } }),
      entitlement = await tx.firstCopyEntitlement.findUnique({
        where: { projectId },
      }),
      payment = await tx.paymentTransaction.findUnique({
        where: { orderId: order.id },
      }),
      production = await tx.firstCopyOrder.findUnique({ where: { projectId } });
    const role = order.buyerId === actor.userId ? "initiator" : "narrator";
    const book = context.current;
    const confirmations = { narrator: false, initiator: false };
    for (const who of ["narrator", "initiator"] as const) {
      const row = await tx.bookConfirmation.findFirst({
        where: { projectId, role: who },
        orderBy: { sequence: "desc" },
      });
      confirmations[who] = !!(
        row &&
        book?.state === "ready" &&
        row.bookId === book.id &&
        row.snapshotHash === book.snapshotHash &&
        row.pdfHash === book.pdf?.sha256 &&
        row.subjectId === subject.id &&
        row.bindingVersion === subject.bindingVersion &&
        row.accessEpoch === project.accessEpoch &&
        (who === "narrator" ||
          (row.addressHash === address?.hash &&
            row.addressVersion === address?.version))
      );
    }
    const snapshot = order.packageSnapshot as unknown as SalesSnapshot;
    const regionCodes = (
      snapshot.admission?.d05?.includedRegionCodes ?? []
    ).filter(
      (code) => !snapshot.admission.d05.excludedRegionCodes.includes(code),
    );
    const review = await tx.careRequest.findFirst({
      where: { projectId, kind: "first_copy_expiry" },
    });
    const blockers: FirstCopyBlocker[] = [];
    if (book?.state !== "ready" || !book.pdf) blockers.push("BOOK_NOT_READY");
    const currentAddress = address?.value as unknown as
      FirstCopyAddress | undefined;
    if (
      !currentAddress ||
      typeof currentAddress.phone !== "string" ||
      !MAINLAND_MOBILE.test(currentAddress.phone) ||
      !regionCodes.includes(currentAddress.regionCode)
    )
      blockers.push("ADDRESS_REQUIRED");
    if (!confirmations.narrator)
      blockers.push("NARRATOR_CONFIRMATION_REQUIRED");
    if (!confirmations.initiator)
      blockers.push("INITIATOR_CONFIRMATION_REQUIRED");
    if (
      !payment ||
      payment.amount !== 99900 ||
      payment.currency !== "CNY" ||
      order.state !== "paid" ||
      !entitlement ||
      entitlement.orderId !== order.id ||
      (entitlement.state !== "available" &&
        !(
          entitlement.state === "reserved" &&
          production?.entitlementId === entitlement.id
        ))
    )
      blockers.push("ENTITLEMENT_UNAVAILABLE");
    if (!terms.creation || terms.policyStatus === "pending")
      blockers.push("POLICY_PENDING");
    else if (terms.creation.state === "paused")
      blockers.push("CREATION_PAUSED");
    else if (terms.creation.state !== "active")
      blockers.push("CREATION_EXPIRED");
    if (book?.state === "ready") {
      const spec = snapshot.d01;
      if (
        !spec ||
        !Number.isInteger(spec.minPages) ||
        !Number.isInteger(spec.maxPages) ||
        book.pageCount === null ||
        book.pageCount < spec.minPages ||
        book.pageCount > spec.maxPages ||
        book.snapshot.specification.widthMm !== spec.widthMm ||
        book.snapshot.specification.heightMm !== spec.heightMm ||
        book.snapshot.specification.bleedMm !== spec.bleedMm
      )
        blockers.push("SPECIFICATION_MISMATCH");
    }
    if (
      await tx.careRequest.findFirst({
        where: {
          projectId,
          kind: { in: ["withdraw", "delete"] },
          state: { not: "completed" },
        },
      })
    )
      blockers.push("PROJECT_FROZEN");
    if (production) blockers.push("ALREADY_SUBMITTED");
    return {
      projectId,
      role,
      book,
      address: {
        version: address?.version ?? 0,
        hash: address?.hash ?? null,
        value:
          role === "initiator" && address
            ? (address.value as unknown as FirstCopyAddress)
            : null,
      },
      confirmations,
      canConfirmNarrator: subject.boundUserId === actor.userId,
      payment: {
        paidAmountFen: payment?.amount ?? 0,
        currency: "CNY",
        copies: 1,
        amountDueFen: 0,
      },
      shipping: {
        regionCodes,
        regionLabels: snapshot.shippingRegionLabels ?? {},
        terms: publicTerms(
          snapshot.d01,
          snapshot.admission,
          snapshot.shippingRegionLabels,
        ).filter((term) =>
          [
            "shipping",
            "service.production",
            "service.logistics",
            "print_specification",
            "creation_window",
            "creation_expiration",
          ].includes(term.key ?? ""),
        ),
      },
      creation: {
        state: terms.creation?.state ?? "pending",
        expiresAt: terms.creation?.expiresAt ?? null,
      },
      expiryReview: {
        available:
          role === "initiator" &&
          terms.creation?.state === "expired" &&
          !review,
        caseId: review?.id ?? null,
      },
      blockers,
      canSubmit: role === "initiator" && blockers.length === 0,
      production: production ? this.orderView(production) : null,
      accessExpiresAt: context.accessExpiresAt,
    };
  }
  context(projectId: string, authorization?: string) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      (tx, actor) => this.contextIn(tx, projectId, actor),
    );
  }
  private async command(
    tx: Prisma.TransactionClient,
    projectId: string,
    actorId: string,
    action: string,
    key: string,
    body: unknown,
  ) {
    if (!/^[-A-Za-z0-9_:]{8,128}$/.test(key)) throw new BadRequestException();
    const where = {
        projectId_actorId_action_key: { projectId, actorId, action, key },
      },
      requestHash = digest(body);
    const prior = await tx.firstCopyCommand.findUnique({ where });
    if (prior && prior.requestHash !== requestHash)
      throw new ConflictException();
    if (prior) return false;
    await tx.firstCopyCommand.create({
      data: { projectId, actorId, action, key, requestHash },
    });
    return true;
  }
  address(
    projectId: string,
    body: FirstCopyAddressDto,
    authorization: string | undefined,
    key: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const current = await this.contextIn(tx, projectId, actor);
        if (current.role !== "initiator") throw new ForbiddenException();
        if (current.production) throw new ConflictException();
        if (
          !(await this.command(
            tx,
            projectId,
            actor.userId,
            "address",
            key,
            body,
          ))
        )
          return current;
        if (body.expectedVersion !== current.address.version)
          throw new ConflictException();
        if (!current.shipping.regionCodes.includes(body.regionCode))
          throw new UnprocessableEntityException();
        const value: FirstCopyAddress = {
          recipientName: body.recipientName.trim(),
          phone: body.phone.trim(),
          regionCode: body.regionCode,
          detail: body.detail.trim(),
        };
        const hash = digest(value);
        if (hash !== current.address.hash)
          await tx.firstCopyAddress.upsert({
            where: { projectId },
            create: { projectId, version: 1, hash, value: json(value) },
            update: { version: { increment: 1 }, hash, value: json(value) },
          });
        return this.contextIn(tx, projectId, actor);
      },
    );
  }
  private assertBook(
    current: FirstCopyContext,
    body: { bookVersionId: string; snapshotHash: string; pdfHash: string },
  ) {
    const book = current.book;
    if (
      !book ||
      book.state !== "ready" ||
      book.id !== body.bookVersionId ||
      book.snapshotHash !== body.snapshotHash ||
      book.pdf?.sha256 !== body.pdfHash
    )
      throw new ConflictException("Current complete PDF required");
    return book;
  }
  confirm(
    projectId: string,
    body: BookConfirmationDto,
    authorization: string | undefined,
    key: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const current = await this.contextIn(tx, projectId, actor);
        if (current.production) throw new ConflictException();
        if (body.role === "initiator" && current.role !== "initiator")
          throw new ForbiddenException();
        if (
          !(await this.command(
            tx,
            projectId,
            actor.userId,
            "confirm",
            key,
            body,
          ))
        )
          return current;
        const book = this.assertBook(current, body);
        if (
          body.role === "initiator" &&
          (!current.address.hash || current.address.hash !== body.addressHash)
        )
          throw new ConflictException();
        if (body.role === "narrator" && body.addressHash)
          throw new BadRequestException();
        let assistedEvidenceId: string | undefined;
        if (body.role === "narrator" && !current.canConfirmNarrator) {
          if (!body.assistedSessionId) throw new ForbiddenException();
          const evidence =
            await this.participation.recordAssistedVersionEvidence(tx, {
              projectId,
              sessionId: body.assistedSessionId,
              operatorUserId: actor.userId,
              content: {
                kind: "book",
                versionId: book.id,
                hash: book.snapshotHash,
              },
              noticeVersion: body.noticeVersion,
              evidenceRef: body.evidenceRef,
              idempotencyKey: key,
            });
          assistedEvidenceId = evidence.id;
        }
        if (
          await tx.bookConfirmation.findFirst({
            where: { projectId, evidenceRef: body.evidenceRef },
          })
        )
          throw new ConflictException("Fresh confirmation evidence required");
        await tx.bookConfirmation.create({
          data: {
            id: randomUUID(),
            projectId,
            role: body.role,
            bookId: book.id,
            snapshotHash: book.snapshotHash,
            pdfHash: book.pdf!.sha256,
            addressHash:
              body.role === "initiator" ? current.address.hash : null,
            addressVersion:
              body.role === "initiator" ? current.address.version : null,
            subjectId: actor.subjectId,
            actorId: actor.userId,
            bindingVersion: actor.bindingVersion,
            accessEpoch: actor.accessEpoch,
            method: assistedEvidenceId
              ? "assisted"
              : body.role === "narrator"
                ? "self_wechat"
                : "initiator",
            assistedEvidenceId,
            noticeVersion: body.noticeVersion,
            evidenceRef: body.evidenceRef,
          },
        });
        return this.contextIn(tx, projectId, actor);
      },
    );
  }
  private async eventIn(
    tx: Prisma.TransactionClient,
    orderId: string,
    kind: "reserved" | "approved",
    actorId: string,
  ) {
    const event = await tx.fulfillmentEvent.create({
      data: { id: randomUUID(), orderId, kind, actorId },
    });
    await tx.fulfillmentOutbox.create({ data: { eventId: event.id } });
  }
  submit(
    projectId: string,
    body: SubmitFirstCopyDto,
    authorization: string | undefined,
    key: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const current = await this.contextIn(tx, projectId, actor);
        if (current.role !== "initiator") throw new ForbiddenException();
        await this.command(tx, projectId, actor.userId, "submit", key, body);
        if (current.production) {
          const prior = current.production;
          if (
            prior.bookVersionId !== body.bookVersionId ||
            prior.snapshotHash !== body.snapshotHash ||
            prior.pdfHash !== body.pdfHash ||
            prior.addressHash !== body.addressHash
          )
            throw new ConflictException();
          return current;
        }
        if (current.creation.state === "expired") {
          await this.expiryIn(tx, projectId, actor.userId, "product");
          return this.contextIn(tx, projectId, actor);
        }
        this.assertBook(current, body);
        if (current.address.hash !== body.addressHash || !current.canSubmit)
          throw new ConflictException(
            "Both confirmations and current entitlement required",
          );
        const project = await tx.project.findUniqueOrThrow({
            where: { id: projectId },
          }),
          entitlement = await tx.firstCopyEntitlement.findUniqueOrThrow({
            where: { projectId },
          }),
          address = await tx.firstCopyAddress.findUniqueOrThrow({
            where: { projectId },
          });
        const confirmations = await tx.bookConfirmation.findMany({
          where: { projectId },
          orderBy: { sequence: "desc" },
        });
        const narrator = confirmations.find((c) => c.role === "narrator")!,
          initiator = confirmations.find((c) => c.role === "initiator")!;
        const reserved = await tx.firstCopyEntitlement.updateMany({
          where: {
            id: entitlement.id,
            projectId,
            orderId: project.orderId!,
            state: "available",
          },
          data: { state: "reserved" },
        });
        if (reserved.count !== 1) throw new ConflictException();
        const row = await tx.firstCopyOrder.create({
          data: {
            id: randomUUID(),
            projectId,
            entitlementId: entitlement.id,
            paymentOrderId: project.orderId!,
            bookId: body.bookVersionId,
            snapshotHash: body.snapshotHash,
            pdfHash: body.pdfHash,
            addressHash: body.addressHash,
            address: json(address.value),
            narratorConfirmationId: narrator.id,
            initiatorConfirmationId: initiator.id,
          },
        });
        await this.eventIn(tx, row.id, "reserved", actor.userId);
        return this.contextIn(tx, projectId, actor);
      },
    );
  }
  private async expiryIn(
    tx: Prisma.TransactionClient,
    projectId: string,
    operatorId: string,
    realm: "product" | "admin",
  ) {
    const existing = await tx.careRequest.findFirst({
      where: { projectId, kind: "first_copy_expiry" },
    });
    if (existing) return existing.id;
    const project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId },
      });
    const row = await tx.careRequest.create({
      data: {
        id: randomUUID(),
        projectId,
        requesterId: realm === "product" ? operatorId : null,
        requesterSubjectId: subject.id,
        operatorId,
        operatorRealm: realm,
        sourceBindingVersion: subject.bindingVersion,
        sourceAccessEpoch: project.accessEpoch,
        idempotencyKey: "first-copy-expiry",
        requestHash: digest({ projectId, kind: "first_copy_expiry" }),
        kind: "first_copy_expiry",
      },
    });
    return row.id;
  }
  expiryReview(
    projectId: string,
    authorization: string | undefined,
    key: string,
  ) {
    return this.participation.withPlanAccess(
      projectId,
      authorization,
      undefined,
      async (tx, actor) => {
        const current = await this.contextIn(tx, projectId, actor);
        if (current.role !== "initiator") throw new ForbiddenException();
        await this.command(
          tx,
          projectId,
          actor.userId,
          "expiry-review",
          key,
          {},
        );
        if (current.creation.state !== "expired") throw new ConflictException();
        await this.expiryIn(tx, projectId, actor.userId, "product");
        return this.contextIn(tx, projectId, actor);
      },
    );
  }
  private approvalView(context: FirstCopyContext): FirstCopyApprovalView {
    return {
      projectId: context.projectId,
      production: context.production!,
      expiryReview: context.expiryReview,
    };
  }
  async approveIn(
    tx: Prisma.TransactionClient,
    orderId: string,
    body: SubmitFirstCopyDto,
    operatorId: string,
    key: string,
  ) {
    const found = await tx.firstCopyOrder.findUnique({
      where: { id: orderId },
    });
    if (!found) throw new NotFoundException();
    const projectId = found.projectId;
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
    const order = await tx.firstCopyOrder.findUniqueOrThrow({
        where: { id: orderId },
      }),
      project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
      }),
      subject = await tx.projectSubject.findUniqueOrThrow({
        where: { projectId },
      }),
      payment = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: project.orderId! },
      });
    if (
      !(await this.participation.bookGrantIn(tx, {
        projectId,
        subjectId: subject.id,
        bindingVersion: subject.bindingVersion,
        accessEpoch: project.accessEpoch,
        operatorId: payment.buyerId,
      }))
    )
      throw new ForbiddenException();
    const actor: Actor = {
      userId: payment.buyerId,
      subjectId: subject.id,
      bindingVersion: subject.bindingVersion,
      accessEpoch: project.accessEpoch,
      method: "participant",
      subjectDecision: null,
      decisionSessionId: null,
      accessExpiresAt: null,
    };
    const current = await this.contextIn(tx, projectId, actor);
    await this.command(tx, projectId, operatorId, "approve", key, body);
    const view = this.orderView(order);
    if (
      view.bookVersionId !== body.bookVersionId ||
      view.snapshotHash !== body.snapshotHash ||
      view.pdfHash !== body.pdfHash ||
      view.addressHash !== body.addressHash
    )
      throw new ConflictException();
    if (current.creation.state === "expired") {
      await this.expiryIn(tx, projectId, operatorId, "admin");
      return this.approvalView(await this.contextIn(tx, projectId, actor));
    }
    this.assertBook(current, body);
    if (
      current.blockers.some((code) => code !== "ALREADY_SUBMITTED") ||
      current.address.hash !== order.addressHash
    )
      throw new ConflictException(
        "Reservation requires current confirmations and entitlement",
      );
    const confirmations = await tx.bookConfirmation.findMany({
      where: {
        projectId,
        id: {
          in: [order.narratorConfirmationId, order.initiatorConfirmationId],
        },
      },
    });
    if (
      confirmations.length !== 2 ||
      confirmations.some(
        (c) =>
          c.bookId !== order.bookId ||
          c.snapshotHash !== order.snapshotHash ||
          c.pdfHash !== order.pdfHash ||
          c.bindingVersion !== subject.bindingVersion ||
          c.accessEpoch !== project.accessEpoch,
      )
    )
      throw new ConflictException();
    if (order.state !== "approved") {
      await tx.firstCopyOrder.update({
        where: { id: orderId },
        data: {
          state: "approved",
          approvedBy: operatorId,
          approvedAt: new Date(),
        },
      });
      await this.eventIn(tx, orderId, "approved", operatorId);
    }
    return this.approvalView(await this.contextIn(tx, projectId, actor));
  }
  async onModuleDestroy() {
    await this.terms.close();
  }
}
@Controller("v1/projects/:id/first-copy")
@ApiTags("First copy")
@ApiBearerAuth()
export class FirstCopyController {
  constructor(private readonly copies: FirstCopies) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async context(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.copies.context(id, req.headers.authorization),
      meta: { requestId: req.id },
    };
  }
  @Post("address")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async address(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: FirstCopyAddressDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.copies.address(
        id,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }

  @Post("confirmations")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async confirm(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BookConfirmationDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.copies.confirm(
        id,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }

  @Post("submit")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async submit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: SubmitFirstCopyDto,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.copies.submit(
        id,
        body,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }

  @Post("expiry-review")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async expiryReview(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return {
      data: await this.copies.expiryReview(
        id,
        req.headers.authorization,
        idempotencyKey(req),
      ),
      meta: { requestId: req.id },
    };
  }
}

@Controller("v1/admin/first-copy")
@ApiTags("Administration first copy")
@ApiCookieAuth("timenook-admin")
export class AdminFirstCopyController {
  constructor(
    private readonly copies: FirstCopies,
    private readonly access: AdminAccess,
  ) {}
  @Post(":id/approve")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: SubmitFirstCopyDto,
    @Req() req: FastifyRequest,
  ) {
    const data = await this.access.run("fulfillment.approve", req, async () => {
      const actor = await this.access.authorized(
        req,
        ADMIN_PERMISSIONS.writeFulfillment,
      );
      return this.access.command(
        req,
        ADMIN_PERMISSIONS.writeFulfillment,
        (tx) =>
          this.copies.approveIn(
            tx,
            id,
            body,
            actor.adminId!,
            idempotencyKey(req),
          ),
      );
    });
    return { data, meta: { requestId: req.id } };
  }
}

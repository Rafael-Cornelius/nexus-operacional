import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { RequestContextService } from "../../infrastructure/request-context/request-context.service";

export interface AuditInput {
  userId?: string;
  module: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  requestOrigin?: string;
  deviceId?: string;
  appVersion?: string;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService
  ) {}

  async record(input: AuditInput, client: Pick<Prisma.TransactionClient, "auditLog"> = this.prisma) {
    const context = this.requestContext.current();
    return client.auditLog.create({
      data: {
        userId: input.userId && input.userId !== "system" ? input.userId : undefined,
        module: input.module,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        before: input.before === undefined ? undefined : (input.before as object),
        after: input.after === undefined ? undefined : (input.after as object),
        reason: input.reason,
        ipAddress: input.ipAddress ?? context?.ipAddress,
        userAgent: input.userAgent ?? context?.userAgent,
        correlationId: input.correlationId ?? context?.correlationId,
        requestOrigin: input.requestOrigin ?? context?.requestOrigin,
        deviceId: input.deviceId ?? context?.deviceId,
        appVersion: input.appVersion ?? context?.appVersion
      }
    });
  }

  list(query: { module?: string; action?: string; userId?: string; take?: string }) {
    return this.prisma.auditLog.findMany({
      where: {
        module: query.module,
        action: query.action,
        userId: query.userId
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(query.take ?? 100), 500),
      include: { user: { select: { id: true, name: true, email: true } } }
    });
  }
}

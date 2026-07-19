import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { RequestContextService } from "./request-context.service";

const correlationPattern = /^[A-Za-z0-9._:-]{8,128}$/;

function cleanHeader(value: string | string[] | undefined, maxLength: number) {
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim().slice(0, maxLength) || undefined;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(request: Request, response: Response, next: NextFunction) {
    const supplied = cleanHeader(request.headers["x-correlation-id"], 128);
    const correlationId = supplied && correlationPattern.test(supplied) ? supplied : randomUUID();
    response.setHeader("x-correlation-id", correlationId);
    this.context.run({
      correlationId,
      ipAddress: request.ip || request.socket.remoteAddress,
      userAgent: cleanHeader(request.headers["user-agent"], 1024),
      requestOrigin: cleanHeader(request.headers.origin, 512),
      deviceId: cleanHeader(request.headers["x-device-id"], 160),
      appVersion: cleanHeader(request.headers["x-app-version"], 80)
    }, next);
  }
}

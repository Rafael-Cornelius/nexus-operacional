import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

export interface RequestMetadata {
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
  requestOrigin?: string;
  deviceId?: string;
  appVersion?: string;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestMetadata>();

  run(metadata: RequestMetadata, callback: () => void) {
    this.storage.run(metadata, callback);
  }

  current() {
    return this.storage.getStore();
  }
}

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./infrastructure/logging/global-exception.filter";
import { allowsMutationRequest } from "./infrastructure/security/csrf-protection";
import type { NextFunction, Request, Response } from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const port = Number(process.env.API_PORT ?? 3333);
  const webOrigin = new URL(
    process.env.WEB_ORIGIN ?? "http://localhost:3000",
  ).origin;

  app.use(helmet());
  app.use((request: Request, response: Response, next: NextFunction) => {
    const allowed = allowsMutationRequest({
      method: request.method,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      secFetchSite:
        typeof request.headers["sec-fetch-site"] === "string"
          ? request.headers["sec-fetch-site"]
          : undefined,
      allowedOrigin: webOrigin,
    });
    if (!allowed) {
      response.status(403).json({
        statusCode: 403,
        message: "Origem da mutacao nao autorizada.",
        error: "Forbidden",
      });
      return;
    }
    next();
  });
  app.enableCors({
    origin: [webOrigin],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(port);
}

bootstrap();

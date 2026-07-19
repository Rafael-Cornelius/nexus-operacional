import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { resolveJwtAccessSecret } from "../../config/production-secrets";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [
    AuditModule,
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtAccessSecret({
          NODE_ENV: config.get<string>("NODE_ENV"),
          JWT_ACCESS_SECRET: config.get<string>("JWT_ACCESS_SECRET")
        }),
        signOptions: { expiresIn: (config.get<string>("JWT_ACCESS_TTL") ?? "15m") as never }
      })
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtModule, JwtAuthGuard, RolesGuard]
})
export class AuthModule {}

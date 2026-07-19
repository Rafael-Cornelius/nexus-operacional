import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { RequestContextMiddleware } from "./infrastructure/request-context/request-context.middleware";
import { RequestContextModule } from "./infrastructure/request-context/request-context.module";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { ProductsModule } from "./modules/products/products.module";
import { ProductionModule } from "./modules/production/production.module";
import { LossesModule } from "./modules/losses/losses.module";
import { OverweightModule } from "./modules/overweight/overweight.module";
import { DowntimeModule } from "./modules/downtime/downtime.module";
import { ProductivityModule } from "./modules/productivity/productivity.module";
import { WeeksModule } from "./modules/weeks/weeks.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { PresentationsModule } from "./modules/presentations/presentations.module";
import { GoalsModule } from "./modules/goals/goals.module";
import { AuditModule } from "./modules/audit/audit.module";
import { ImportModule } from "./modules/import/import.module";
import { BackupsModule } from "./modules/backups/backups.module";
import { DosageModule } from "./modules/dosage/dosage.module";
import { EquipmentModule } from "./modules/equipment/equipment.module";
import { ShiftsModule } from "./modules/shifts/shifts.module";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation.module";
import { JwtAuthGuard } from "./modules/auth/jwt-auth.guard";
import { RolesGuard } from "./modules/auth/roles.guard";
import { validateProductionEnvironment } from "./config/production-secrets";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateProductionEnvironment }),
    ScheduleModule.forRoot(),
    RequestContextModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    ProductionModule,
    LossesModule,
    OverweightModule,
    DowntimeModule,
    ProductivityModule,
    WeeksModule,
    DashboardModule,
    ReportsModule,
    PresentationsModule,
    GoalsModule,
    AuditModule,
    ImportModule,
    BackupsModule,
    DosageModule,
    EquipmentModule,
    ShiftsModule,
    ReconciliationModule
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}

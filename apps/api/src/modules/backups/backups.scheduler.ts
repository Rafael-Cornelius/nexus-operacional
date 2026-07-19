import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { BackupsService } from "./backups.service";

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name);

  constructor(
    private readonly backups: BackupsService,
    private readonly config: ConfigService
  ) {}

  @Cron("0 2 * * *", { name: "nexus-daily-backup" })
  async createDailyBackup() {
    if (this.config.get<string>("BACKUP_SCHEDULE_ENABLED") !== "true") return;

    try {
      const backup = await this.backups.create();
      const retention = await this.backups.enforceRetention();
      this.logger.log(`Backup automatico concluido: ${backup.fileName}; removidos por retencao: ${retention.removed}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "falha desconhecida";
      this.logger.error(`Backup automatico falhou: ${message}`);
    }
  }
}

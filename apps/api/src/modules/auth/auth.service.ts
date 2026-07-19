import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService
  ) {}

  async login(payload: unknown) {
    const input = loginSchema.parse(payload);
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { roles: { include: { role: true } } }
    });

    if (!user || !user.active || user.deletedAt) {
      await this.recordAuthEvent("login_failed", undefined, { email: input.email });
      throw new UnauthorizedException("Credenciais invalidas.");
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      await this.recordAuthEvent("login_failed", user.id, { email: input.email });
      throw new UnauthorizedException("Credenciais invalidas.");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    const roles = user.roles.map((item) => item.role.code);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      sv: user.sessionVersion
    });
    await this.recordAuthEvent("login", user.id, { email: user.email, roles });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles
      }
    };
  }

  async me(currentUser: CurrentUser | undefined) {
    if (!currentUser) {
      throw new UnauthorizedException("Sessao ausente ou expirada.");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        active: true,
        deletedAt: true,
        roles: { select: { role: { select: { code: true } } } }
      }
    });

    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException("Sessao invalida ou expirada.");
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles.map((item) => item.role.code)
    };
  }

  async logout(currentUser: CurrentUser | undefined) {
    if (!currentUser) {
      throw new UnauthorizedException("Sessao ausente ou expirada.");
    }
    await this.recordAuthEvent("logout", currentUser.id, { email: currentUser.email, roles: currentUser.roles });
  }

  private async recordAuthEvent(action: "login" | "login_failed" | "logout", userId: string | undefined, after: unknown) {
    await this.audit.record({
      userId,
      module: "auth",
      action,
      entity: "User",
      entityId: userId,
      after
    });
  }
}

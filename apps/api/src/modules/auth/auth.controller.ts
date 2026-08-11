import { Body, Controller, Get, Post, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";
import { resolveAuthCookieSameSite } from "../../config/production-secrets";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "./current-user.decorator";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

const sessionCookieName = "nexus_session";

function sessionCookieOptions() {
  const maxAge = Number(process.env.JWT_ACCESS_COOKIE_MAX_AGE_MS ?? 15 * 60 * 1000);
  const sameSite = resolveAuthCookieSameSite(process.env);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite,
    path: "/",
    maxAge
  };
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.login(body);
    response.cookie(sessionCookieName, session.accessToken, sessionCookieOptions());
    return { user: session.user };
  }

  @Get("me")
  async me(@CurrentUserData() user: CurrentUser | undefined) {
    return { user: await this.auth.me(user) };
  }

  @Post("logout")
  async logout(@CurrentUserData() user: CurrentUser | undefined, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(user);
    response.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  }
}

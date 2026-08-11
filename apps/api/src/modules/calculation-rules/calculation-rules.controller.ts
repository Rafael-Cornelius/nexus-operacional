import { Body, Controller, Get, Param, ParseIntPipe, Post } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CalculationRulesService } from "./calculation-rules.service";

@Roles("ADMIN")
@Controller("calculation-rules")
export class CalculationRulesController {
  constructor(private readonly calculationRules: CalculationRulesService) {}

  @Get()
  list() {
    return this.calculationRules.list();
  }

  @Post(":ruleId/versions/:version/approve")
  approve(
    @Param("ruleId") ruleId: string,
    @Param("version", ParseIntPipe) version: number,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.calculationRules.approve(ruleId, version, body, user);
  }

  @Post(":ruleId/versions/:version/retire")
  retire(
    @Param("ruleId") ruleId: string,
    @Param("version", ParseIntPipe) version: number,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.calculationRules.retire(ruleId, version, body, user);
  }
}

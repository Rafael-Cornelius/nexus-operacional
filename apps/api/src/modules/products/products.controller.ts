import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query() query: { active?: string; search?: string }) {
    return this.products.list(query);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.products.create(body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.products.update(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get(":id/prices")
  pricePeriods(@Param("id") id: string) {
    return this.products.pricePeriods(id);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/prices")
  addPricePeriod(@Param("id") id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.products.addPricePeriod(id, body, user);
  }

  @Roles("ADMIN")
  @Delete(":id")
  deactivate(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.products.deactivate(id, user);
  }
}

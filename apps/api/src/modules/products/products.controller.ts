import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query() query: { active?: string; search?: string; deleted?: string }) {
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
  addPricePeriod(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.products.addPricePeriod(id, body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Post(":id/prices/:priceId/approve")
  approvePricePeriod(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("priceId", ParseUUIDPipe) priceId: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.products.approvePricePeriod(id, priceId, body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Post(":id/prices/:priceId/retire")
  retirePricePeriod(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("priceId", ParseUUIDPipe) priceId: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.products.retirePricePeriod(id, priceId, body, user);
  }

  @Roles("ADMIN")
  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.products.remove(id, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Patch(":id/deactivate")
  deactivate(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.products.deactivate(id, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Patch(":id/activate")
  activate(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.products.activate(id, user);
  }

  @Roles("ADMIN")
  @Post(":id/restore")
  restore(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.products.restore(id, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get(":id")
  byId(@Param("id") id: string) {
    return this.products.byId(id);
  }
}

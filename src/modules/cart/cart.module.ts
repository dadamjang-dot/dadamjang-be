import { Module } from "@nestjs/common";
import { CartResolver } from "./cart.resolver";
import { CartService } from "./cart.service";

@Module({ providers: [CartService, CartResolver], exports: [CartService] })
export class CartModule {}

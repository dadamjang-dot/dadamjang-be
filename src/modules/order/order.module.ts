import { Module } from "@nestjs/common";
import { OrderResolver } from "./order.resolver";
import { OrderService } from "./order.service";

@Module({ providers: [OrderService, OrderResolver], exports: [OrderService] })
export class OrderModule {}
